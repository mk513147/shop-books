import React, { useEffect } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import Animated, {
	useSharedValue,
	useAnimatedStyle,
	withTiming,
	Layout,
	LinearTransition,
} from "react-native-reanimated";
import { theme } from "@theme";

type Props = {
	title: string;
	total: number;
	collapsed: boolean;
	onToggle: () => void;
};

export default function MonthHeader({
	title,
	total,
	collapsed,
	onToggle,
}: Props) {
	const isExpanded = !collapsed;
	const rotate = useSharedValue(isExpanded ? 1 : 0);

	useEffect(() => {
		rotate.value = withTiming(isExpanded ? 1 : 0, { duration: 200 });
	}, [isExpanded]);

	const arrowStyle = useAnimatedStyle(() => ({
		transform: [{ rotate: `${rotate.value * 180}deg` }],
	}));

	return (
		<Animated.View
			layout={LinearTransition.springify().damping(18).stiffness(180)}
			style={{
				backgroundColor: theme.colors.background,
				paddingVertical: 14,
				paddingHorizontal: 16,
				borderBottomWidth: 1,
				borderBottomColor: "#e5e5e5",
			}}
		>
			<TouchableOpacity
				onPress={onToggle}
				style={{
					flexDirection: "row",
					justifyContent: "space-between",
					alignItems: "center",
				}}
			>
				<View>
					<Text
						style={{
							fontSize: 13,
							color: theme.colors.textSecondary,
							letterSpacing: 1,
						}}
					>
						{title.toUpperCase()}
					</Text>

					<Text
						style={{
							fontSize: 16,
							fontWeight: "700",
							color: total >= 0 ? theme.colors.income : theme.colors.expense,
						}}
					>
						₹ {total}
					</Text>
				</View>

				<Animated.Text style={arrowStyle}>▼</Animated.Text>
			</TouchableOpacity>
		</Animated.View>
	);
}
