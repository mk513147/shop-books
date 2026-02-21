import React from "react";
import { View, Text, TouchableOpacity } from "react-native";
import Animated, {
	LinearTransition,
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	FadeIn,
	FadeOut,
	StretchInY,
	StretchOutY,
} from "react-native-reanimated";
import { theme } from "@theme";
import ImageGrid from "@components/ImageGrid/ImageGrid";

type Props = {
	item: any;
	isExpanded: boolean;
	onToggle: () => void;
	onOpenViewer: (images: string[], index: number) => void;
};

export default function TransactionRow({
	item,
	isExpanded,
	onToggle,
	onOpenViewer,
}: Props) {
	const progress = useSharedValue(isExpanded ? 1 : 0);

	React.useEffect(() => {
		progress.value = withTiming(isExpanded ? 1 : 0, {
			duration: 250,
		});
	}, [isExpanded]);
	const animatedStyle = useAnimatedStyle(() => ({
		opacity: progress.value,
	}));
	if (!item) return null;

	return (
		<Animated.View
			layout={LinearTransition.springify().damping(18).stiffness(180)}
			style={{
				marginHorizontal: 8,
				marginVertical: 4,
			}}
		>
			<TouchableOpacity
				onPress={onToggle}
				activeOpacity={0.9}
				style={{
					backgroundColor: theme.colors.card,
					padding: 12,
					borderRadius: 10,
				}}
			>
				{/* Compact */}
				<View
					style={{
						flexDirection: "row",
						justifyContent: "space-between",
					}}
				>
					<Text>{item.category}</Text>

					<Text
						style={{
							color:
								item.type === "income"
									? theme.colors.income
									: theme.colors.expense,
							fontWeight: "600",
						}}
					>
						₹ {item.amount}
					</Text>
				</View>

				<Text
					style={{
						color: theme.colors.textSecondary,
						marginTop: 4,
					}}
				>
					{item.date}
				</Text>

				{/* Expanded Section */}
				<Animated.View
					entering={StretchInY}
					exiting={StretchOutY}
					style={[
						{
							overflow: "hidden",
						},
						animatedStyle,
					]}
				>
					{isExpanded && (
						<Animated.View
							entering={FadeIn}
							exiting={FadeOut}
							layout={LinearTransition.springify().damping(18).stiffness(180)}
							style={{ marginTop: 8 }}
						>
							{item.supplierName && <Text>Supplier: {item.supplierName}</Text>}
							{item.note && <Text>Note: {item.note}</Text>}
							<Text>Payment: {item.paymentType}</Text>

							{item.imagePath && (
								<ImageGrid
									imagePath={item.imagePath}
									onPressImage={onOpenViewer}
								/>
							)}
						</Animated.View>
					)}
				</Animated.View>
			</TouchableOpacity>
		</Animated.View>
	);
}
